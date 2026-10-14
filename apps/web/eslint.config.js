import base from '@zachmail/config/eslint'
import reactHooks from 'eslint-plugin-react-hooks'

export default [
  { ignores: ['dist-perf/**', 'test-results/**', 'playwright-report/**'] },
  ...base,
  reactHooks.configs.flat['recommended-latest'] ?? reactHooks.configs['recommended-latest'],
]
