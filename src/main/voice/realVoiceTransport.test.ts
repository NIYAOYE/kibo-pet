import { createServer } from 'node:http'
import { describe, expect, it } from 'vitest'
import { realPostSse } from './realVoiceTransport'

describe('realPostSse', () => {
  it('does not create an HTTP request when its signal was already aborted', async () => {
    let requests = 0
    const server = createServer((_req, res) => {
      requests++
      res.end()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('test server did not expose a TCP port')
    const ctrl = new AbortController()
    ctrl.abort()

    try {
      await expect(realPostSse(address.port, '/speak', { text: 'hello' }, () => {}, ctrl.signal)).rejects.toThrow('cancelled')
      expect(requests).toBe(0)
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    }
  })
})
