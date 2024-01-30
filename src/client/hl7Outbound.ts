import EventEmitter from 'node:events'
import fs from 'node:fs'
import net, { Socket } from 'node:net'
import tls from 'node:tls'
import { Batch } from '../builder/batch.js'
import { FileBatch } from '../builder/fileBatch.js'
import { Message } from '../builder/message.js'
import { PROTOCOL_MLLP_FOOTER, PROTOCOL_MLLP_HEADER } from '../utils/constants.js'
import { ReadyState } from '../utils/enum.js'
import { HL7FatalError } from '../utils/exception.js'
import { ClientListenerOptions, normalizeClientListenerOptions, OutboundHandler } from '../utils/normalizedClient.js'
import { expBackoff, randomString } from '../utils/utils.js'
import { Client } from './client.js'
import { InboundResponse } from './module/inboundResponse.js'

/** HL7 Outbound Class
 * @description Create a connection to a server on a particular port.
 * @since 1.0.0 */
export class HL7Outbound extends EventEmitter {
  /** @internal */
  private _awaitingResponse: boolean
  /** @internal */
  _connectionTimer: NodeJS.Timeout | undefined
  /** @internal */
  _handler: ((res: InboundResponse) => Promise<void>) | undefined
  /** @internal */
  private readonly _main: Client
  /** @internal */
  private readonly _nodeId: string
  /** @internal */
  private readonly _opt: ReturnType<typeof normalizeClientListenerOptions>
  /** @internal */
  private _retryCount: number
  /** @internal */
  _retryTimer: NodeJS.Timeout | undefined
  /** @internal */
  private _socket: Socket | undefined
  /** @internal */
  private readonly _sockets: Map<any, any>
  /** @internal */
  protected _readyState: ReadyState
  /** @internal */
  _pendingSetup: Promise<boolean> | boolean
  /** @internal */
  private _responseBuffer: string
  /** @internal */
  private readonly _initialConnection: boolean
  /** @internal */
  readonly stats = {
    /** Total acknowledged messages back from server.
     * @since 1.1.0 */
    acknowledged: 0,
    /** Total message sent to server.
     * @since 1.1.0 */
    sent: 0
  }

  /**
   * @since 1.0.0
   * @param client The client parent that we are connecting too.
   * @param props The individual port connection options.
   * Some values will be defaulted by the parent server connection.
   * @param handler The function that will send the returned information back to the client after we got a response from the server.
   * @example
   * ```ts
   * const OB = client.createOutbound({ port: 3000 }, async (res) => {})
   * ```
   */
  constructor (client: Client, props: ClientListenerOptions, handler?: OutboundHandler) {
    super()
    this._awaitingResponse = false
    this._initialConnection = false
    this._connectionTimer = undefined
    this._handler = handler // eslint-disable-line @typescript-eslint/no-misused-promises
    this._main = client
    this._nodeId = randomString(5)

    this._opt = normalizeClientListenerOptions(props)

    this._pendingSetup = true
    this._sockets = new Map()
    this._retryCount = 0
    this._retryTimer = undefined
    this._readyState = ReadyState.CONNECTING
    this._responseBuffer = ''
    this._socket = undefined

    this._connect = this._connect.bind(this)
  }

  /** Close Client Listener Instance.
   * @description Force close a connection.
   * It Will stop any re-connection timers.
   * If you want to restart, your app has to restart the connection.
   * @since 1.0.0
   * @example
   * ```ts
   * OB.close()
   * ```
   */
  async _close (): Promise<boolean> {
    // mark that we set our internal that we are closing, so we do not try to re-connect
    this._readyState = ReadyState.CLOSING
    this._sockets.forEach((socket) => {
      if (typeof socket.destroyed !== 'undefined') {
        socket.end()
        socket.destroy()
      }
    })
    this._sockets.clear()

    this.emit('client.close')

    return true
  }

  /**
   * Read a file.
   * @description We need to read a file.
   * We are not doing anything else other than getting the {@link Buffer} of the file,
   * so we can pass it onto the File Batch class to send it to the {@link sendMessage} method as a separate step
   * @since 1.0.0
   * @param fullFilePath The full file path of the file we need to read.
   */
  async readFile (fullFilePath: string): Promise<FileBatch> {
    try {
      const regex = /\n/mg
      const subst = '\\r'
      const fileBuffer = fs.readFileSync(fullFilePath)
      const text = fileBuffer.toString().replace(regex, subst)
      return new FileBatch({ text })
    } catch (e: any) {
      throw new HL7FatalError(500, `Unable to read file: ${fullFilePath}`)
    }
  }

  /** Send a HL7 Message to the Listener
   * @description This function sends a message/batch/file batch to the remote side.
   * It has the ability, if set to auto-retry (defaulted to 1 re-connect before connection closes)
   * @since 1.0.0
   * @param message The message we need to send to the port.
   * @example
   * ```ts
   *
   * // the OB was set from the orginial 'createOutbound' method.
   *
   * let message = new Message({
   *  messageHeader: {
   *    msh_9_1: "ADT",
   *    msh_9_2: "A01",
   *    msh_11_1: "P" // marked for production here in the example
   *  }
   * })
   *
   * await OB.sendMessage(message)
   *
   * ```
   */
  async sendMessage (message: Message | Batch | FileBatch): Promise<void> {
    this._socket = this._connect(async (): Promise<void> => {
      this._readyState = ReadyState.CONNECTED

      let attempts = 0
      const maxAttempts = typeof this._opt.maxAttempts === 'undefined' ? this._main._opt.maxAttempts : this._opt.maxAttempts

      const checkConnection = async (): Promise<boolean> => {
        return this._readyState === ReadyState.CONNECTED
      }

      const checkAck = async (): Promise<boolean> => {
        return this._awaitingResponse
      }

      const checkSend = async (_message: string): Promise<boolean> => {
        while (true) { // noinspection InfiniteLoopJS
          try {
            if ((this._readyState === ReadyState.CLOSED) || (this._readyState === ReadyState.CLOSING)) {
              // noinspection ExceptionCaughtLocallyJS
              throw new HL7FatalError(500, 'In an invalid state to be able to send message.')
            }
            if (this._readyState !== ReadyState.CONNECTED) {
              // if we are not connected,
              // check to see if we are now connected.
              if (this._pendingSetup === false) {
                this._pendingSetup = checkConnection().finally(() => {
                  this._pendingSetup = false
                })
              }
            } else if (this._readyState === ReadyState.CONNECTED && this._opt.waitAck && this._awaitingResponse) {
              // Ok, we ar now confirmed connected.
              // However, since we are checking
              // to make sure we wait for an ACKNOWLEDGEMENT from the server,
              // that the message was gotten correctly from the last one we sent.
              // We are still waiting, we need to recheck again
              // if we are not connected,
              // check to see if we are now connected.
              if (this._pendingSetup === false) {
                this._pendingSetup = checkAck().finally(() => {
                  this._pendingSetup = false
                })
              }
            }
            return await this._pendingSetup
          } catch (err: any) {
            Error.captureStackTrace(err)
            if (++attempts >= maxAttempts) {
              throw err
            } else {
              emitter.emit('retry', err)
            }
          }
        }
      }

      const emitter = new EventEmitter()

      // get the message
      const theMessage = message.toString()

      // check to see if we should be sending
      await checkSend(theMessage)

      // ok, if our options are to wait for an acknowledgement, set the var to "true"
      if (this._opt.waitAck) {
        this._awaitingResponse = true
      }

      // add MLLP settings to the message
      const messageToSend = Buffer.from(`${PROTOCOL_MLLP_HEADER}${theMessage}${PROTOCOL_MLLP_FOOTER}`)

      this._socket?.write(messageToSend, this._opt.encoding, () => {
        // we sent a message
        ++this.stats.sent
        // emit
        this.emit('client.sent', this.stats.sent)
      })
    })

    if (this._opt.connectionTimeout > 0) {
      this._connectionTimer = setTimeout(() => {
        // end this socket
        this._socket?.end()
        // kill
        this._socket?.destroy(new HL7FatalError(500, 'Connection timed out.'))
        // reset
        this._removeSocket(this._nodeId)
      }, this._opt.connectionTimeout)
    }

    this._addSocket(this._nodeId, this._socket, true)

    this._socket.setNoDelay(true)

    this._socket.on('ready', () => {
      // reset, kill any re-connection timer
      this._reset()
      // emit
      this.emit('ready')
    })

    this._socket.on('data', async (buffer) => {
      this._awaitingResponse = false
      this._responseBuffer += buffer.toString()

      while (this._responseBuffer !== '') {
        const indexOfVT = this._responseBuffer.indexOf(PROTOCOL_MLLP_HEADER)
        const indexOfFSCR = this._responseBuffer.indexOf(PROTOCOL_MLLP_FOOTER)

        let loadedMessage = this._responseBuffer.substring(indexOfVT, indexOfFSCR + 2)
        this._responseBuffer = this._responseBuffer.slice(indexOfFSCR + 2, this._responseBuffer.length)

        loadedMessage = loadedMessage.replace(PROTOCOL_MLLP_HEADER, '')

        // is there is F5 and CR in this message?
        if (loadedMessage.includes(PROTOCOL_MLLP_FOOTER)) {
          // strip them out
          loadedMessage = loadedMessage.replace(PROTOCOL_MLLP_FOOTER, '')
          if (typeof this._handler !== 'undefined') {
            // response
            const response = new InboundResponse(loadedMessage)
            // got an ACK, failure or not
            ++this.stats.acknowledged
            // update ack total
            this.emit('client.acknowledged', this.stats.acknowledged)
            // send it back
            await this._handler(response)
          }
        }
      }

      // let's close the connection
      await this._close()
    })

    this._socket.on('error', async () => {
      // error, we are going to force close
      this._readyState = ReadyState.CLOSING
      // send error event
      this.emit('error')
      // let's force close the connection
      await this._close()
    })

    this._socket.on('timeout', async (): Promise<void> => {
      const maxConnectionAttempts = typeof this._opt.maxAttempts === 'undefined' ? this._main._opt.maxAttempts : this._opt.maxAttempts
      const retryCount = this._retryCount
      if (retryCount < maxConnectionAttempts && (this._readyState === ReadyState.CONNECTING || this._readyState === ReadyState.OPEN) && this._initialConnection) {
        // retry high
        const retryHigh = typeof this._opt.retryHigh === 'undefined' ? this._main._opt.retryHigh : this._opt.retryLow
        // retry low
        const retryLow = typeof this._opt.retryLow === 'undefined' ? this._main._opt.retryLow : this._opt.retryLow
        // increase retry count
        ++this._retryCount
        // reset, kill any re-connection timer
        this._reset()
        // calculate delay
        const delay = expBackoff(retryLow, retryHigh, this._retryCount)
        // tell this system we are now open, but not yet trying to connect to the server again
        this._readyState = ReadyState.OPEN
        // emit that we are in the timeout phase
        this.emit('timeout')
        // build the retry timer
        this._retryTimer = setTimeout(async (): Promise<void> => await this.sendMessage(message), delay)
      } else if (retryCount >= maxConnectionAttempts || (this._readyState === ReadyState.CONNECTING && !this._initialConnection) || !this._initialConnection) {
        // mark this now as a closing
        this._readyState = ReadyState.CLOSING
        // close the socket for good
        await this._close()
        // send error event
        this.emit('error')
      }
    })
  }

  /** @internal */
  private _addSocket (nodeId: string, socket: any, b: boolean): void {
    const s = this._sockets.get(nodeId)
    if (!b && typeof s !== 'undefined' && typeof s.destroyed !== 'undefined') {
      return
    }
    this._sockets.set(nodeId, socket)
  }

  /** @internal */
  private _connect (handler: () => void): Socket {
    let socket: Socket
    const host = this._main._opt.host
    const port = this._opt.port

    if (typeof this._main._opt.tls !== 'undefined') {
      socket = tls.connect({
        host,
        port,
        timeout: this._opt.connectionTimeout,
        ...this._main._opt.socket,
        ...this._main._opt.tls
      }, () => {
        this._listener(socket)
        handler()
      })
    } else {
      socket = net.connect({
        host,
        port,
        timeout:
        this._opt.connectionTimeout
      }, () => {
        this._listener(socket)
        handler()
      })
    }

    return socket
  }

  /** @internal */
  private _listener (socket: Socket): void {
    // set no delay
    socket.setNoDelay(true)

    // add socket
    this._addSocket(this._nodeId, socket, true)

    // check to make sure we do not max out on connections, we shouldn't...
    if (this._sockets.size > this._opt.maxConnections) {
      this._manageConnections()
    }

    this._readyState = ReadyState.CONNECTED
  }

  /** @internal */
  private _manageConnections (): void {
    let count = this._sockets.size - this._opt.maxConnections
    if (count <= 0) {
      return
    }

    const list: Array<{ nodeID: any, lastUsed: any }> = []
    this._sockets.forEach((socket, nodeID) => list.push({ nodeID, lastUsed: socket.lastUsed }))
    list.sort((a, b) => a.lastUsed - b.lastUsed)

    count = Math.min(count, list.length - 1)
    const removable = list.slice(0, count)

    removable.forEach(({ nodeID }) => this._removeSocket(nodeID))
  }

  /** @internal */
  private _removeSocket (nodeId: string): void {
    const socket = this._sockets.get(nodeId)
    if (typeof socket !== 'undefined' && typeof socket.destroyed !== 'undefined') {
      socket.destroy()
    }
    this._sockets.delete(nodeId)
  }

  /** @internal */
  private _reset (): void {
    if (typeof this._connectionTimer !== 'undefined') {
      clearTimeout(this._connectionTimer)
    }
    this._connectionTimer = undefined
  }
}

export default HL7Outbound
