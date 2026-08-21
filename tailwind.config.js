/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        navy: '#0d1b3e',
        gold: '#c9a84c',
        'navy-light': '#1a2d5a',
        'page-bg': '#f5f7fc',
        // #c9a84c on white measures ~2.3:1 contrast — well under WCAG AA's
        // 4.5:1 floor for text. Fine for gold-on-navy (badges, the logo
        // wordmark), never fine for gold text ON a light background. Use
        // gold-ink for any link/interactive text sitting on white or
        // page-bg — links, edit actions, "Sign up free" on the login card.
        'gold-ink': '#8a6f1f',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
}
