/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        brandBlue: {
          50: '#f0f7ff',
          100: '#e0effe',
          200: '#bae2fd',
          300: '#7ccafd',
          400: '#38aefc',
          500: '#0e94f3',
          600: '#0276d9',
          700: '#035eb1',
          800: '#075091',
          900: '#0c4378',
          950: '#082b4e',
        },
        stripeIndigo: {
          50: '#f4f2ff',
          100: '#ebe8ff',
          500: '#533afd',
          600: '#4434d4',
          700: '#2e2b8c',
          light: '#665efd',
          subdued: '#b9b9f9',
        },
        stripeInk: {
          DEFAULT: '#0d253d',
          secondary: '#273951',
          mute: '#64748d',
          mute2: '#61718a',
        },
        stripeCream: '#f5e9d4',
        stripeBgSoft: '#f6f9fc',
        stripeHairline: '#e3e8ee',
        stripeHairlineInput: '#a8c3de',
        stripeRuby: '#ea2261',
      }
    },
  },
  plugins: [],
}
