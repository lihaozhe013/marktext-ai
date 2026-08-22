import log from 'electron-log'

export const featureLog = (message: string, ...args: unknown[]): void => {
  log.info(`[ai-editor] ${message}`, ...args)
}

export const connectionLog = (message: string, ...args: unknown[]): void => {
  log.info(`[ai-connection] ${message}`, ...args)
}

export const requestBodyPresetLog = (message: string, ...args: unknown[]): void => {
  log.info(`[request_body_preset] ${message}`, ...args)
}
