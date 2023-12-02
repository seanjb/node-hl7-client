import { HL7_MSH_MESSAGE_TYPE } from './generic.js'
import { HL7_SPEC_BASE } from './specification.js'

export const HL7_2_7_MSH_DEFAULT = {
  msh: {}
}

/**
 * HL7 2.7 MSH Specification
 * @since 1.0.0
 */
export interface HL7_2_7_MSH {
  /** Message Type
   * @description The message type of the Hl7 message we are sending.
   * @since 1.0.0 */
  msh_9: HL7_MSH_MESSAGE_TYPE
  /** Message Control ID
   * @description The message control ID that should ID this actual message.
   * @since 1.0.0 */
  msh_10: string
}

/**
 * Hl7 Specification Version 2.7
 * @description Used to indicate that the message should follow 2.7 specification for retrieval or building a message.
 * @since 1.0.0
 */
export class HL7_2_7 extends HL7_SPEC_BASE {
  checkMSH (msh: HL7_2_7_MSH): HL7_2_7_MSH {
    if (typeof msh.msh_9.msh_9_1 === 'undefined' ||
      typeof msh.msh_9.msh_9_2 === 'undefined' ||
      typeof msh.msh_9.msh_9_3 === 'undefined') {
      throw new Error('MSH.1 must be one character in length.')
    }

    if (msh.msh_9.msh_9_1.length !== 3) {
      throw new Error('MSH.9.1 must be 3 characters in length.')
    }

    if (msh.msh_9.msh_9_2.length !== 3) {
      throw new Error('MSH.9.2 must be 3 characters in length.')
    }

    if (msh.msh_9.msh_9_3.length !== 7) {
      throw new Error('MSH.9.3 must be 7 characters in length.')
    }

    if (typeof msh.msh_10 === 'undefined') {
      throw new Error('MSH.9.10 must be defined.')
    }

    if (msh.msh_10.length > 199) {
      throw new Error('MSH.9.10 must less than 199 characters.')
    }

    return msh
  }
}