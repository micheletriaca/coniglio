import neostandard from 'neostandard'

const rules = neostandard({
  ignores: ['lib/**'],
  ts: true,
  filesTs: ['**/*.ts']
})

export default rules
