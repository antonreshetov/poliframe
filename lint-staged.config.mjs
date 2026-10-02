export default {
  '*.{js,ts,vue}': (files) => {
    const authored = files.filter(
      file => !file.includes('/src/renderer/components/ui/'),
    )
    if (!authored.length)
      return []
    const args = authored
      .map(file => `'${file.replaceAll('\'', '\'\\\'\'')}'`)
      .join(' ')
    return [`prettier --write ${args}`, `eslint --fix ${args}`]
  },
}
