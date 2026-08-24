const diagnosticVariable = 'KAREL_PRODUCTION_DIAGNOSTIC_GREP'

if (process.env[diagnosticVariable] !== undefined) {
  process.stderr.write(
    `${diagnosticVariable} must be unset for the complete production gate.\n`,
  )
  process.exitCode = 1
} else {
  process.stdout.write('Karel production validation environment: complete matrix\n')
}
