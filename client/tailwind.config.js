/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  theme: {
    extend: {
      colors: {
        brown: "#3D2317",
        tan: "#D2A679",
        cream: "#FAF7F2",
      },
      fontFamily: {
        sans: ["DM Sans", "Noto Sans Arabic", "system-ui", "sans-serif"],
        display: ["Fraunces", "Noto Sans Arabic", "serif"],
      },
    },
  },
};
