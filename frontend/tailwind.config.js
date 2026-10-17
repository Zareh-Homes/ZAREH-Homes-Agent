/**
 * Colours are CSS variables (src/index.css) holding RGB channels, so every
 * token works with Tailwind's opacity modifiers (bg-critical/10) and dark mode
 * is a token swap rather than `dark:` variants on every element.
 */
const token = (name) => `rgb(var(--${name}) / <alpha-value>)`;

/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        page: token("surface-page"),
        card: token("surface-card"),
        sunken: token("surface-sunken"),
        line: token("line"),
        ink: { DEFAULT: token("ink"), 2: token("ink-2"), 3: token("ink-3") },
        accent: { DEFAULT: token("accent"), track: token("accent-track"), on: token("on-accent") },
        good: token("good"),
        warning: token("warning"),
        serious: token("serious"),
        critical: token("critical"),
      },
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "-apple-system", "Segoe UI", "Roboto", "sans-serif"],
      },
    },
  },
  plugins: [],
};
