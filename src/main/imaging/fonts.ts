import process from 'node:process'

// fontfile registers bundled fonts with Fontconfig, not macOS CoreText.
process.env.PANGOCAIRO_BACKEND = 'fontconfig'

export const captionFonts: Record<string, string> = {
  'Inter-SemiBold': 'Inter SemiBold,',
  'Inter-Medium': 'Inter Medium,',
  'Inter-Regular': 'Inter,',
  'Inter-Light': 'Inter Light,',
  'JetBrainsMono-Regular': 'JetBrains Mono,',
  'MartianMono-Bold': 'Martian Mono, Bold',
  'MartianMono-Regular': 'Martian Mono,',
  'CormorantGaramond-MediumItalic': 'Cormorant Garamond Medium, Italic',
  'CormorantGaramond-Medium': 'Cormorant Garamond Medium,',
  'GeistMono-Medium': 'Geist Mono Medium,',
  'GeistMono-Regular': 'Geist Mono,',
  'GeistMono-Light': 'Geist Mono Light,',
  'PlayfairDisplay-MediumItalic': 'Playfair Display Medium, Italic',
  'IBMPlexMono-Regular': 'IBM Plex Mono,',
  'IBMPlexMono-Light': 'IBM Plex Mono Light,',
  'Montserrat-Light': 'Montserrat Light,',
  'Montserrat-Regular': 'Montserrat,',
}
