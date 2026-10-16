import base from '@zachhub/config/eslint'
import reactHooks from 'eslint-plugin-react-hooks'

export default [
  { ignores: ['.expo/**', 'ios/**', 'android/**'] },
  ...base,
  reactHooks.configs.flat['recommended-latest'] ?? reactHooks.configs['recommended-latest'],
]
