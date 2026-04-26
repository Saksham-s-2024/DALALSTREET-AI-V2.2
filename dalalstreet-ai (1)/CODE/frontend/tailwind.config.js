/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        brand: { green: "#22d3a0", indigo: "#6366f1", bg: "#070c14" },
      },
      fontFamily: {
        mono: ["IBM Plex Mono", "Fira Code", "Courier New", "monospace"],
        sans: ["IBM Plex Sans", "system-ui", "sans-serif"],
      },
    },
  },
  plugins: [],
};
