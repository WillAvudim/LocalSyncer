import * as crypto from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as util from 'util'
import * as zlib from 'zlib'


const IV_SIZE_BYTES: number = 16
const KEY_SIZE: number = 32
const CRYPTO_ALGO: string = `AES-256-CTR`

const KEY: Buffer = StringKeyToBuffer(fs.readFileSync(path.join(os.homedir(), ".dropbox_secret_key"), "utf8").trim())

const fs_readFile = util.promisify(fs.readFile)
const fs_writeFile = util.promisify(fs.writeFile)
const zlib_brotliCompress: any = util.promisify(zlib.brotliCompress)
const zlib_brotliDecompress: any = util.promisify(zlib.brotliDecompress)


export async function TransformForward(from_path: string, to_path: string): Promise<void> {
  const buffer: Buffer = await fs_readFile(from_path)
  const compressed: Buffer = await zlib_brotliCompress(buffer, {
    [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
    [zlib.constants.BROTLI_PARAM_QUALITY]: zlib.constants.BROTLI_MAX_QUALITY,
    [zlib.constants.BROTLI_OPERATION_FINISH]: 1,
    [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buffer.length,
  })

  const encrypted: Buffer = Encrypt(compressed)
  await fs_writeFile(to_path, encrypted)
}


export async function TransformBackward(from_path: string, to_path: string): Promise<void> {
  const buffer: Buffer = await fs_readFile(from_path)
  const decrypted: Buffer = Decrypt(buffer)
  const uncompressed: Buffer = await zlib_brotliDecompress(decrypted, {
    [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
    [zlib.constants.BROTLI_PARAM_QUALITY]: zlib.constants.BROTLI_MAX_QUALITY,
    [zlib.constants.BROTLI_OPERATION_FINISH]: 1,
    [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buffer.length,
  })

  await fs_writeFile(to_path, uncompressed)
}


function Encrypt(input: Buffer): Buffer {
  const iv: Buffer = crypto.randomBytes(IV_SIZE_BYTES)
  const cipher = crypto.createCipheriv(CRYPTO_ALGO, KEY, iv)

  cipher.write(input)
  cipher.final()
  return Buffer.concat([iv, cipher.read()])
}


function Decrypt(input: Buffer): Buffer {
  const iv: Buffer = input.slice(0, IV_SIZE_BYTES)
  const cipher = crypto.createCipheriv(CRYPTO_ALGO, KEY, iv)

  cipher.write(input.slice(IV_SIZE_BYTES))
  cipher.final()
  return cipher.read()
}


function StringKeyToBuffer(key: string): Buffer {
  const key_as_buffer: Buffer = Buffer.from(key)
  for (let i = 0; i < KEY_SIZE; ++i) {
    key_as_buffer.writeInt8(key_as_buffer.readInt8(i) ^ key_as_buffer.readInt8(key_as_buffer.length - 1 - i), i)
  }

  return key_as_buffer.slice(0, KEY_SIZE)
}
