import fsPromises from 'fs/promises'
import crypto from 'crypto'

export const readJson = async <T>(filePath: string, fallback: T): Promise<T> => {
  try {
    const value: unknown = JSON.parse(await fsPromises.readFile(filePath, 'utf8'))
    return value as T
  } catch {
    return fallback
  }
}

export const writeJsonAtomic = async(filePath: string, value: unknown): Promise<void> => {
  const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`
  await fsPromises.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600
  })
  try {
    await fsPromises.rename(tempPath, filePath)
  } catch {
    await fsPromises.unlink(filePath).catch(() => undefined)
    await fsPromises.rename(tempPath, filePath)
  }
  try {
    await fsPromises.chmod(filePath, 0o600)
  } catch {
    // chmod is best effort on filesystems that do not expose POSIX modes.
  }
}
