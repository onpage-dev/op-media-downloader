const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')

// Function to notarize and staple the DMG file
async function notarizeAndStapleDmg() {
  // Adjust the path to your 'dist' folder
  const distPath = path.resolve(__dirname, '../dist') // Ensure it matches your directory structure
  const version = require('../package.json').version // Get the version from package.json

  // Find the first .dmg file with the version in its name
  const dmgFile = fs
    .readdirSync(distPath)
    .find(file => file.includes(version) && file.endsWith('.dmg'))

  if (!dmgFile) {
    throw new Error(
      `No DMG file found in ${distPath} matching version ${version}`,
    )
  }

  const dmgPath = path.join(distPath, dmgFile)

  console.log(`Notarizing ${dmgPath}...`)

  // Step 1: Notarize the DMG
  await new Promise((resolve, reject) => {
    const notarizeProcess = spawn('xcrun', [
      'notarytool',
      'submit',
      dmgPath,
      '--keychain-profile',
      'AC_PASSWORD',
      '--wait',
    ])

    notarizeProcess.stdout.on('data', data => {
      console.log(`[stdout]: ${data}`)
    })

    notarizeProcess.stderr.on('data', data => {
      console.error(`[stderr]: ${data}`)
    })

    notarizeProcess.on('close', code => {
      if (code === 0) {
        console.log(`Notarization successful for ${dmgPath}`)
        resolve()
      } else {
        reject(new Error(`Notarization failed with exit code ${code}`))
      }
    })
  })

  // Step 2: Staple the notarization ticket to the DMG
  console.log(`Stapling notarization ticket to ${dmgPath}...`)

  await new Promise((resolve, reject) => {
    const stapleProcess = spawn('xcrun', ['stapler', 'staple', dmgPath])

    stapleProcess.stdout.on('data', data => {
      console.log(`[stdout]: ${data}`)
    })

    stapleProcess.stderr.on('data', data => {
      console.error(`[stderr]: ${data}`)
    })

    stapleProcess.on('close', code => {
      if (code === 0) {
        console.log(`Stapling successful for ${dmgPath}`)
        resolve()
      } else {
        reject(new Error(`Stapling failed with exit code ${code}`))
      }
    })
  })

  console.log(`Notarization and stapling completed for ${dmgPath}`)
}

// Run the notarization and stapling process
notarizeAndStapleDmg().catch(error => {
  console.error('Notarization or stapling failed:', error)
  process.exit(1)
})
