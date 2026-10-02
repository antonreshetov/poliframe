import antfu from '@antfu/eslint-config'

export default antfu({
  ignores: ['src/renderer/components/ui/**'],
  rules: {
    'vue/max-attributes-per-line': [
      'error',
      {
        singleline: 1,
      },
    ],
  },
})
