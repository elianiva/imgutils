/**
 * Fixed pool of module workers. Jobs wait in a queue and are handed to the
 * first idle worker, so memory stays bounded to `size` concurrent images.
 */
export function createPool(size) {
  const idle = []
  const queue = []

  function spawn() {
    const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' })
    worker.job = null
    worker.onmessage = (event) => {
      const job = worker.job
      worker.job = null
      idle.push(worker)
      if (job) job.resolve(event.data)
      pump()
    }
    worker.onerror = (event) => {
      event.preventDefault()
      const job = worker.job
      worker.job = null
      worker.terminate()
      spawn()
      if (job) job.reject(new Error(event.message || 'Image worker failed to start'))
      pump()
    }
    idle.push(worker)
  }

  function pump() {
    while (idle.length > 0 && queue.length > 0) {
      const worker = idle.pop()
      const job = queue.shift()
      worker.job = job
      job.onStart?.()
      worker.postMessage(job.message)
    }
  }

  for (let index = 0; index < size; index += 1) spawn()

  return {
    run(message, { onStart } = {}) {
      return new Promise((resolve, reject) => {
        queue.push({ message, resolve, reject, onStart })
        pump()
      })
    },
  }
}
