/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        bgMain: '#0c0e14',
        bgSidebar: '#090b10',
        bgCard: 'rgba(22, 27, 34, 0.85)',
        borderSubtle: 'rgba(255, 255, 255, 0.08)',
        accentBlue: '#58a6ff',
        accentGreen: '#238636',
        accentRed: '#da3633',
      }
    },
  },
  plugins: [],
}
