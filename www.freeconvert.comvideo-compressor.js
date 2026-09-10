/*
· base : https://www.freeconvert.com/video-compressor
· creator : phrzy
· channel : https://whatsapp.com/channel/0029VbD1zGq6mYPUbtVh6U0L/121
*/

const axios = require('axios')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const API = 'https://api.freeconvert.com/v1'
const INPUT = process.argv[2] || 'downloads/input.mp4'
const TARGET = +(process.argv[3] || 60)

const api = async (method, url, body, token) => {
  const cfg = { method, url: API + url, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } }
  if (body) cfg.data = body
  const { data } = await axios(cfg)
  return data
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function guestToken() {
  const { data } = await axios.get('https://api.freeconvert.com/v1/account/guest')
  return data
}

function jobBody() {
  return {
    tasks: {
      'import-1': { operation: 'import/upload' },
      'compress-1': {
        operation: 'compress',
        input: 'import-1',
        input_format: 'mp4',
        output_format: 'mp4',
        options: {
          video_codec_compress: 'libx264',
          compress_video: 'by_percentage',
          video_compress_quality_percentage: TARGET
        }
      },
      'export-1': { operation: 'export/url', input: 'compress-1', filename: 'wOrvCj_compressed.mp4' }
    }
  }
}

async function uploadFile(job, token, file) {
  const task = job.tasks.find(t => t.operation === 'import/upload')
  const form = task.result.form
  const fd = new FormData()
  fd.append('signature', form.parameters.signature)
  fd.append('file', new Blob([fs.readFileSync(file)], { type: 'video/mp4' }), path.basename(file))
  const { data } = await axios.post(form.url, fd, { headers: { authorization: `Bearer ${token}` } })
  return data
}

async function waitDone(id, token) {
  for (let i = 0; i < 120; i++) {
    const job = await api('get', `/process/jobs/${id}`, null, token)
    if (job.status === 'completed') return job
    if (job.status === 'failed' || job.status === 'error') throw new Error('job failed: ' + JSON.stringify(job))
    process.stdout.write(`status ${job.status}...\n`)
    await sleep(5000)
  }
  throw new Error('timeout waiting for job')
}

async function download(url, dir = 'downloads') {
  fs.mkdirSync(dir, { recursive: true })
  const res = await fetch(url)
  if (!res.ok) throw new Error('HTTP ' + res.status)
  const buf = Buffer.from(await res.arrayBuffer())
  const md5 = crypto.createHash('md5').update(buf).digest('hex')
  const cd = res.headers.get('content-disposition') || ''
  const name = (cd.match(/filename="?([^";]+)/) || [null, null])[1] || 'compressed.mp4'
  const file = path.join(dir, `${Date.now()}_${md5}_${name}`)
  fs.writeFileSync(file, buf)
  return { file, url, md5, bytes: buf.length }
}

async function compress() {
  const token = await guestToken()
  const created = await api('post', '/process/jobs', jobBody(), token)
  const id = created.id
  if (!id) throw new Error('no job id: ' + JSON.stringify(created))
  const upload = await uploadFile(created, token, INPUT)
  const job = await waitDone(id, token)
  const task = job.tasks.find(t => t.operation === 'export/url')
  const url = task && task.result.url
  const saved = url ? await download(url) : null
  return { id, status: job.status, upload, job, saved }
}

compress()
  .then(r => console.log(JSON.stringify(r, null, 2)))
  .catch(console.error)

module.exports = { compress, download, guestToken }