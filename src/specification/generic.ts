/** @internal */
export interface HL7_MSH_MESSAGE_TYPE {
  /** Message Code */
  msh_9_1: string
  /** Trigger Event */
  msh_9_2: string
}

/** @internal */
export interface HL7_MSH_PROCESSING_TYPE {
  /** Processing ID
   * @since 1.0.0 */
  msh_11_1?: 'D' | 'P' | 'T'
  /** Processing Mode
   * @since 1.0.0 */
  msh_11_2?: 'A' | 'I' | 'R' | 'T' | ''
}
