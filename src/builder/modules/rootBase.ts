import { HL7FatalError } from '../../utils/exception.js'
import { ClientBuilderOptions } from '../../utils/normalizedBuilder.js'
import { Delimiters } from '../../utils/enum.js'
import { decodeHexString, escapeForRegExp } from '../../utils/utils.js'
import { NodeBase } from './nodeBase.js'
/**
 * Root Base
 * @since 1.0.0
 * @extends NodeBase
 */
export class RootBase extends NodeBase {
  /** @internal */
  _opt: any

  /** @internal */
  private readonly _delimiters: string
  /** @internal */
  private readonly _matchEscape: RegExp
  /** @internal */
  private readonly _matchUnescape: RegExp

  /** @internal */
  private static readonly _defaultDelimiters = '\r|^~\\&'
  /** @internal */
  private static readonly _defaultMatchUnescape = RootBase._makeMatchUnescape(RootBase._defaultDelimiters)
  /** @internal */
  private static readonly _defaultMatchEscape = RootBase._makeMatchEscape(RootBase._defaultDelimiters)

  constructor (opt: ClientBuilderOptions) {
    super(null, opt.text, Delimiters.Segment)

    this._delimiters = `${opt.newLine}${opt.separatorField}${opt.separatorComponent}${opt.separatorRepetition}${opt.separatorEscape}${opt.separatorSubComponent}`

    if (this._delimiters === RootBase._defaultDelimiters) {
      this._matchUnescape = RootBase._defaultMatchUnescape
      this._matchEscape = RootBase._defaultMatchEscape
    } else {
      this._matchUnescape = RootBase._makeMatchUnescape(this._delimiters)
      this._matchEscape = RootBase._makeMatchEscape(this._delimiters)
    }
  }

  /**
   * @internal
   * @since 1.0.0
   * @param delimiters
   * @private
   */
  protected static _makeMatchEscape (delimiters: string): RegExp {
    const sequences = [
      escapeForRegExp(delimiters[Delimiters.Escape]),
      escapeForRegExp(delimiters[Delimiters.Field]),
      escapeForRegExp(delimiters[Delimiters.Repetition]),
      escapeForRegExp(delimiters[Delimiters.Component]),
      escapeForRegExp(delimiters[Delimiters.SubComponent])
    ]
    return new RegExp(sequences.join('|'), 'g')
  }

  /**
   * @internal
   * @since 1.0.0
   * @param delimiters
   * @private
   */
  protected static _makeMatchUnescape (delimiters: string): RegExp {
    // setup regular expression for matching escape sequences, see http://www.hl7standards.com/blog/2006/11/02/hl7-escape-sequences/
    const matchEscape = escapeForRegExp(delimiters[Delimiters.Escape])
    return new RegExp([matchEscape, '[^', matchEscape, ']*', matchEscape].join(''), 'g')
  }

  /**
   * Get Delimiters
   * @since 1.0.0
   */
  get delimiters (): string {
    return this._delimiters
  }

  /**
   * Escape String
   * @since 1.0.0
   * @param text
   */
  escape (text: string): string {
    if (text === null) {
      throw new HL7FatalError(500, 'text must be passed in escape function.')
    }

    return text.replace(this._matchEscape, (match: string) => {
      let ch: string = ''

      switch (match) {
        case this._delimiters[Delimiters.Escape]:
          ch = 'E'
          break
        case this._delimiters[Delimiters.Field]:
          ch = 'F'
          break
        case this._delimiters[Delimiters.Repetition]:
          ch = 'R'
          break
        case this._delimiters[Delimiters.Component]:
          ch = 'S'
          break
        case this._delimiters[Delimiters.SubComponent]:
          ch = 'T'
          break
      }

      if (typeof ch !== 'undefined') {
        const escape = this._delimiters[Delimiters.Escape]
        return `${escape}${ch}${escape}`
      }

      throw new HL7FatalError(500, `Escape sequence for ${match} is not known.`)
    })
  }

  /** @internal */
  split (data: string, segments: string[] = []): string[] {
    const getSegIndex = [...this._getSegIndexes(['FHS', 'BHS', 'MSH', 'BTS', 'FTS'], data)]
    getSegIndex.sort((a, b) => parseInt(a) - parseInt(b))
    for (let i = 0; i < getSegIndex.length; i++) {
      const start = parseInt(getSegIndex[i])
      let end = parseInt(getSegIndex[i + 1])
      if (i + 1 === getSegIndex.length) {
        end = data.length
      }
      segments.push(data.slice(start, end))
    }
    return segments
  }

  /**
   * Unescape Text
   * @since 1.0.0
   * @param text
   */
  unescape (text: string): string {
    if (text === null) {
      throw new HL7FatalError(500, 'text must be passed in unescape function.')
    }

    // Slightly faster for a normal case of no escape sequences in text
    if (!text.includes(this._delimiters[Delimiters.Escape])) {
      return text
    }

    return text.replace(this._matchUnescape, (match: string) => {
      switch (match.slice(1, 2)) {
        case 'E':
          return this._delimiters[Delimiters.Escape]
        case 'F':
          return this._delimiters[Delimiters.Field]
        case 'R':
          return this._delimiters[Delimiters.Repetition]
        case 'S':
          return this._delimiters[Delimiters.Component]
        case 'T':
          return this._delimiters[Delimiters.SubComponent]
        case 'X':
          return decodeHexString(match.slice(2, match.length - 1))
        case 'C':
        case 'H':
        case 'M':
        case 'N':
        case 'Z':
          break
        default:
          return match
      }

      return ''
    })
  }

  /** @internal */
  private _getSegIndexes (names: string[], data: string, list: string[] = []): string[] {
    for (let i = 0; i < names.length; i++) {
      const regex = new RegExp(`(\\n|\\r|)(${names[i]})\\|`, 'g')
      let m
      while ((m = regex.exec(data)) != null) {
        const s = m[0]
        if (s.includes('\r\n')) {
          m.index = m.index + 2
        } else if (s.includes('\n')) {
          m.index++
        } else if (s.includes('\r')) {
          m.index++
        }
        if (m.index !== null) {
          list.push(m.index.toString())
        }
      }
    }
    return list
  }
}
