const config = require('./../config')
const db = require('knex')(config.database)
const fetch = require('node-fetch')
const ffmpeg = require('fluent-ffmpeg')
const fs = require('fs')
const path = require('path')
const perms = require('./permissionController')
const sharp = require('sharp')

const utilsController = {}
const uploadsDir = path.join(__dirname, '..', config.uploads.folder)
const thumbsDir = path.join(uploadsDir, 'thumbs')
const thumbUnavailable = path.join(__dirname, '../public/images/unavailable.png')
const cloudflareAuth = config.cloudflare.apiKey && config.cloudflare.email && config.cloudflare.zoneId

utilsController.imageExtensions = ['.webp', '.jpg', '.jpeg', '.gif', '.png', '.tiff', '.tif', '.svg']
utilsController.videoExtensions = ['.webm', '.mp4', '.wmv', '.avi', '.mov', '.mkv']

utilsController.mayGenerateThumb = extname => {
  return (config.uploads.generateThumbs.image && utilsController.imageExtensions.includes(extname)) ||
    (config.uploads.generateThumbs.video && utilsController.videoExtensions.includes(extname))
}

// expand if necessary (must be lower case); for now only preserves some known tarballs
utilsController.preserves = ['.tar.gz', '.tar.z', '.tar.bz2', '.tar.lzma', '.tar.lzo', '.tar.xz']

utilsController.extname = filename => {
  // Always return blank string if the filename does not seem to have a valid extension
  // Files such as .DS_Store (anything that starts with a dot, without any extension after) will still be accepted
  if (!/\../.test(filename)) return ''

  let lower = filename.toLowerCase() // due to this, the returned extname will always be lower case
  let multi = ''
  let extname = ''

  // check for multi-archive extensions (.001, .002, and so on)
  if (/\.\d{3}$/.test(lower)) {
    multi = lower.slice(lower.lastIndexOf('.') - lower.length)
    lower = lower.slice(0, lower.lastIndexOf('.'))
  }

  // check against extensions that must be preserved
  for (let i = 0; i < utilsController.preserves.length; i++)
    if (lower.endsWith(utilsController.preserves[i])) {
      extname = utilsController.preserves[i]
      break
    }

  if (!extname)
    extname = lower.slice(lower.lastIndexOf('.') - lower.length) // path.extname(lower)

  return extname + multi
}

utilsController.escape = string => {
  // MIT License
  // Copyright(c) 2012-2013 TJ Holowaychuk
  // Copyright(c) 2015 Andreas Lubbe
  // Copyright(c) 2015 Tiancheng "Timothy" Gu

  if (!string) return string

  const str = '' + string
  const match = /["'&<>]/.exec(str)

  if (!match) return str

  let escape
  let html = ''
  let index = 0
  let lastIndex = 0

  for (index = match.index; index < str.length; index++) {
    switch (str.charCodeAt(index)) {
      case 34: // "
        escape = '&quot;'
        break
      case 38: // &
        escape = '&amp;'
        break
      case 39: // '
        escape = '&#39;'
        break
      case 60: // <
        escape = '&lt;'
        break
      case 62: // >
        escape = '&gt;'
        break
      default:
        continue
    }

    if (lastIndex !== index)
      html += str.substring(lastIndex, index)

    lastIndex = index + 1
    html += escape
  }

  return lastIndex !== index
    ? html + str.substring(lastIndex, index)
    : html
}

utilsController.authorize = async (req, res) => {
  const token = req.headers.token
  if (token === undefined) {
    res.status(401).json({ success: false, description: 'No token provided.' })
    return
  }

  const user = await db.table('users').where('token', token).first()
  if (user) {
    if (user.enabled === false || user.enabled === 0) {
      res.json({ success: false, description: 'This account has been disabled.' })
      return
    }
    return user
  }

  res.status(401).json({
    success: false,
    description: 'Invalid token.'
  })
}

utilsController.generateThumbs = (name, force) => {
  return new Promise(resolve => {
    const extname = utilsController.extname(name)
    const thumbname = path.join(thumbsDir, name.slice(0, -extname.length) + '.png')
    fs.lstat(thumbname, async (error, stats) => {
      if (error && error.code !== 'ENOENT') {
        console.error(error)
        return resolve(false)
      }

      if (!error && stats.isSymbolicLink()) {
        // Unlink symlink
        const unlink = await new Promise((resolve, reject) => {
          fs.unlink(thumbname, error => {
            if (error) return reject(error)
            return resolve(true)
          })
        }).catch(console.error)
        if (!unlink) return resolve(false)
      }

      // Only make thumbnail if it does not exist (ENOENT)
      if (!error && !stats.isSymbolicLink() && !force) return resolve(true)

      // Full path to input file
      const input = path.join(__dirname, '..', config.uploads.folder, name)

      new Promise((resolve, reject) => {
        // If image extension
        if (utilsController.imageExtensions.includes(extname)) {
          const resizeOptions = {
            width: 200,
            height: 200,
            fit: 'contain',
            background: {
              r: 0,
              g: 0,
              b: 0,
              alpha: 0
            }
          }
          const image = sharp(input)
          return image
            .metadata()
            .then(metadata => {
              if (metadata.width > resizeOptions.width || metadata.height > resizeOptions.height) {
                return image
                  .resize(resizeOptions)
                  .toFile(thumbname)
              } else if (metadata.width === resizeOptions.width && metadata.height === resizeOptions.height) {
                return image
                  .toFile(thumbname)
              } else {
                const x = resizeOptions.width - metadata.width
                const y = resizeOptions.height - metadata.height
                return image
                  .extend({
                    top: Math.floor(y / 2),
                    bottom: Math.ceil(y / 2),
                    left: Math.floor(x / 2),
                    right: Math.ceil(x / 2),
                    background: resizeOptions.background
                  })
                  .toFile(thumbname)
              }
            })
            .then(() => resolve(true))
            .catch(reject)
        }

        // Otherwise video extension
        ffmpeg.ffprobe(input, (error, metadata) => {
          if (error) return reject(error)
          ffmpeg(input)
            .inputOptions([
              `-ss ${parseInt(metadata.format.duration) * 20 / 100}`
            ])
            .output(thumbname)
            .outputOptions([
              '-vframes 1',
              '-vf scale=200:200:force_original_aspect_ratio=decrease'
            ])
            .on('error', reject)
            .on('end', () => resolve(true))
            .run()
        })
      })
        .then(resolve)
        .catch(error => {
          console.error(`${name}: ${error.toString()}`)
          fs.symlink(thumbUnavailable, thumbname, error => {
            if (error) console.error(error)
            resolve(!error)
          })
        })
    })
  })
}

utilsController.deleteFile = (filename, set) => {
  return new Promise((resolve, reject) => {
    const extname = utilsController.extname(filename)
    return fs.unlink(path.join(uploadsDir, filename), error => {
      if (error && error.code !== 'ENOENT') return reject(error)
      const identifier = filename.split('.')[0]
      // eslint-disable-next-line curly
      if (set) {
        set.delete(identifier)
        // console.log(`Removed ${identifier} from identifiers cache (deleteFile)`)
      }
      if (utilsController.imageExtensions.includes(extname) || utilsController.videoExtensions.includes(extname)) {
        const thumb = `${identifier}.png`
        return fs.unlink(path.join(thumbsDir, thumb), error => {
          if (error && error.code !== 'ENOENT') return reject(error)
          resolve(true)
        })
      }
      resolve(true)
    })
  })
}

utilsController.bulkDeleteFiles = async (field, values, user, set) => {
  if (!user || !['id', 'name'].includes(field)) return

  const ismoderator = perms.is(user, 'moderator')
  const files = await db.table('files')
    .whereIn(field, values)
    .where(function () {
      if (!ismoderator)
        this.where('userid', user.id)
    })

  // an array of file object
  const deletedFiles = []

  // an array of value of the specified field
  const failed = values.filter(value => !files.find(file => file[field] === value))

  // Delete all files physically
  await Promise.all(files.map(file => {
    return new Promise(async resolve => {
      await utilsController.deleteFile(file.name)
        .then(() => deletedFiles.push(file))
        .catch(error => {
          failed.push(file[field])
          console.error(error)
        })
      resolve()
    })
  }))

  if (!deletedFiles.length) return failed

  // Delete all files from database
  const deletedIds = deletedFiles.map(file => file.id)
  const deleteDb = await db.table('files')
    .whereIn('id', deletedIds)
    .del()
    .catch(console.error)
  if (!deleteDb) return failed

  if (set)
    deletedFiles.forEach(file => {
      const identifier = file.name.split('.')[0]
      set.delete(identifier)
      // console.log(`Removed ${identifier} from identifiers cache (bulkDeleteFiles)`)
    })

  const filtered = files.filter(file => deletedIds.includes(file.id))

  // Update albums if necessary
  if (deleteDb) {
    const albumids = []
    filtered.forEach(file => {
      if (file.albumid && !albumids.includes(file.albumid))
        albumids.push(file.albumid)
    })
    await db.table('albums')
      .whereIn('id', albumids)
      .update('editedAt', Math.floor(Date.now() / 1000))
      .catch(console.error)
  }

  // Purge Cloudflare's cache if necessary
  if (config.cloudflare.purgeCache)
    utilsController.purgeCloudflareCache(filtered.map(file => file.name), true, true)
      .then(results => {
        for (const result of results)
          if (result.errors.length)
            result.errors.forEach(error => console.error(`CF: ${error}`))
      })

  return failed
}

utilsController.purgeCloudflareCache = async (names, uploads, thumbs) => {
  if (!Array.isArray(names) || !names.length || !cloudflareAuth)
    return [{
      success: false,
      files: [],
      errors: ['An unexpected error occured.']
    }]

  let domain = config.domain
  if (!uploads) domain = config.homeDomain

  const thumbNames = []
  names = names.map(name => {
    if (uploads) {
      const url = `${domain}/${name}`
      const extname = utilsController.extname(name)
      if (thumbs && utilsController.mayGenerateThumb(extname))
        thumbNames.push(`${domain}/thumbs/${name.slice(0, -extname.length)}.png`)
      return url
    } else {
      return name === 'home' ? domain : `${domain}/${name}`
    }
  })
  names = names.concat(thumbNames)

  // Split array into multiple arrays with max length of 30 URLs
  // https://api.cloudflare.com/#zone-purge-files-by-url
  const MAX_LENGTH = 30
  const files = []
  while (names.length)
    files.push(names.splice(0, MAX_LENGTH))

  const url = `https://api.cloudflare.com/client/v4/zones/${config.cloudflare.zoneId}/purge_cache`
  const results = []
  await new Promise(resolve => {
    const purge = async i => {
      const result = {
        success: false,
        files: files[i],
        errors: []
      }

      try {
        const fetchPurge = await fetch(url, {
          method: 'POST',
          body: JSON.stringify({
            files: result.files
          }),
          headers: {
            'Content-Type': 'application/json',
            'X-Auth-Email': config.cloudflare.email,
            'X-Auth-Key': config.cloudflare.apiKey
          }
        }).then(res => res.json())
        result.success = fetchPurge.success
        if (Array.isArray(fetchPurge.errors) && fetchPurge.errors.length)
          result.errors = fetchPurge.errors.map(error => `${error.code}: ${error.message}`)
      } catch (error) {
        result.errors = [error.toString()]
      }

      results.push(result)

      if (i < files.length - 1)
        purge(i + 1)
      else
        resolve()
    }
    purge(0)
  })

  return results
}

module.exports = utilsController
