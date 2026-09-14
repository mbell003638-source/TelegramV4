/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        amoled: '#000000',
        'amoled-card': '#05070f',
        'amoled-card-hover': '#090e1c',
        'amoled-border': '#121929',
        'amoled-border-active': '#2563eb',
        'neon-blue': '#38bdf8',
        'electric-blue': '#3b82f6',
      },
      boxShadow: {
        'neon-blue': '0 0 25px rgba(56, 189, 248, 0.25)',
        'neon-glow': '0 0 35px rgba(37, 99, 235, 0.35)',
        'amoled-glow': '0 0 40px rgba(59, 130, 246, 0.15)',
      },
      animation: {
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'glow': 'glow 2s ease-in-out infinite alternate',
      },
      keyframes: {
        glow: {
          '0%': { boxShadow: '0 0 10px rgba(59, 130, 246, 0.3)' },
          '100%': { boxShadow: '0 0 25px rgba(56, 189, 248, 0.6)' },
        }
      }
    },
  },
  plugins: [],
};
