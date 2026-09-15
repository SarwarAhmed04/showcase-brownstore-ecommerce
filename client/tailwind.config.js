/** @type {import('tailwindcss').Config} */

/* Every colour is authored as an "R G B" triplet in a CSS variable so the same
   token can be used at any opacity (`bg-primary/20`) and swapped wholesale
   between the espresso and cream skins. `<alpha-value>` is what makes that
   work — Tailwind substitutes the opacity modifier into the rgb() call. */
const withAlpha = (v) => `rgb(var(${v}) / <alpha-value>)`

export default {
  darkMode: ['class', '[data-theme="espresso"]'],
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      /* ==================================================== palette ====
         Brown is the whole system — every neutral is derived from it, so
         nothing on the page is ever a true grey. Caramel is the only hue
         allowed on a call to action; patina, clay and moss are semantic
         only, never decorative. */
      colors: {
        // ---- brand scales -------------------------------------------------
        bean: {
          50: '#f7f1ea', 100: '#ece0d2', 200: '#d8c0a6', 300: '#c09f7d',
          400: '#a67c53', 500: '#8a5f3a', 600: '#6d482c', 700: '#523524',
          800: '#38241a', 900: '#241611', 950: '#160d0a',
        },
        caramel: {
          100: '#fff2dc', 200: '#ffe0b0', 300: '#ffcd85', 400: '#f5b45c',
          500: '#e39a3c', 600: '#c37c28', 700: '#9b601c',
        },
        // the counterpoint — stops the palette reading as flat sepia
        patina: {
          200: '#cfe0dc', 300: '#a3c2bd', 400: '#74a19b',
          500: '#4f817b', 600: '#3a635e',
        },
        clay: {
          200: '#f5d3c4', 300: '#e8ad94', 400: '#d68764',
          500: '#bd6842', 600: '#9a5133',
        },
        moss: {
          200: '#d5e0c6', 300: '#b0c496', 400: '#8aa76c',
          500: '#6b884f', 600: '#526b3c',
        },
        cream: '#fdf8f2',
        brown: '#3d2317',
        tan: '#d2a679',
        bg: withAlpha('--bg'),
        'bg-2': withAlpha('--bg-2'),
        fg: withAlpha('--text'),
        'fg-dim': withAlpha('--text-dim'),
        'fg-mute': withAlpha('--text-mute'),
        'primary-fg': withAlpha('--primary-foreground'),

        // ---- semantic bridge ---------------------------------------------
        // shadcn/ui components reference these names. Pointing them at the
        // Brown Store variables is what makes an unmodified shadcn Button
        // come out espresso-and-gold instead of default slate.
        border: withAlpha('--border'),
        input: withAlpha('--input'),
        ring: withAlpha('--ring'),
        background: withAlpha('--background'),
        foreground: withAlpha('--foreground'),
        primary: {
          DEFAULT: withAlpha('--primary'),
          foreground: withAlpha('--primary-foreground'),
        },
        secondary: {
          DEFAULT: withAlpha('--secondary'),
          foreground: withAlpha('--secondary-foreground'),
        },
        muted: {
          DEFAULT: withAlpha('--muted'),
          foreground: withAlpha('--muted-foreground'),
        },
        // NB: in shadcn's vocabulary "accent" means the hover surface inside
        // menus and lists — not the brand accent. The brand accent is
        // `primary`. Conflating the two is why themed shadcn often looks off.
        //
        // Brown Store already owns `--accent` for the gold brand colour, so
        // shadcn's accent is pointed at its own variable instead. Renaming
        // gold everywhere to satisfy a library would be the wrong trade.
        accent: {
          DEFAULT: withAlpha('--accent-surface'),
          foreground: withAlpha('--accent-surface-foreground'),
        },
        // semantic status hues, available as bg-success / text-warning / …
        success: withAlpha('--success'),
        warning: withAlpha('--warning'),
        info: withAlpha('--info'),
        destructive: {
          DEFAULT: withAlpha('--destructive'),
          foreground: withAlpha('--destructive-foreground'),
        },
        card: {
          DEFAULT: withAlpha('--card'),
          foreground: withAlpha('--card-foreground'),
        },
        popover: {
          DEFAULT: withAlpha('--popover'),
          foreground: withAlpha('--popover-foreground'),
        },
      },

      /* ================================================== typography ====
         A 1.2 minor third with line-heights baked in, replacing ~80 arbitrary
         bracket values. Overriding the defaults (rather than adding new names)
         is deliberate: it makes the scale the only way to size text. */
      fontSize: {
        '2xs': ['0.6875rem', { lineHeight: '1rem' }],      // 11/16 · labels, table meta
        xs: ['0.75rem', { lineHeight: '1.125rem' }],       // 12/18 · captions, badges
        sm: ['0.8125rem', { lineHeight: '1.25rem' }],      // 13/20 · UI body, table cells
        base: ['0.9375rem', { lineHeight: '1.5rem' }],     // 15/24 · prose
        lg: ['1.125rem', { lineHeight: '1.625rem' }],      // 18/26 · card titles
        xl: ['1.375rem', { lineHeight: '1.75rem' }],       // 22/28 · panel headings
        '2xl': ['1.75rem', { lineHeight: '2rem' }],        // 28/32 · section heads
        '3xl': ['2.25rem', { lineHeight: '2.375rem' }],    // 36/38 · page titles
        '4xl': ['3rem', { lineHeight: '3rem' }],           // 48/48 · hero
        '5xl': ['4.25rem', { lineHeight: '4rem' }],        // 68/64 · hero large
        '6xl': ['5.5rem', { lineHeight: '5rem' }],         // 88/80 · display only
      },

      fontFamily: {
        display: ['Fraunces', '"Noto Sans Arabic"', 'Georgia', 'serif'],
        sans: ['"Plus Jakarta Sans"', '"Noto Sans Arabic"', 'system-ui', 'sans-serif'],
      },

      /* ===================================================== rhythm ==== */
      spacing: {
        'section-sm': '3.5rem', // 56 · between sibling blocks
        section: '5.5rem',      // 88 · between page sections
        'section-lg': '8rem',   // 128 · around hero and footer
      },

      borderRadius: {
        // canonical set — three, not seven
        card: '1.25rem',
        panel: '1.75rem',
        pill: '9999px',
        // shadcn derives its own from --radius
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 4px)',
        sm: 'calc(var(--radius) - 8px)',
        // TODO(phase 3): migrate rounded-xl2/xl3 to card/panel, then delete
        xl2: '1.75rem',
        xl3: '2.25rem',
      },

      /* ================================================== motion ====
         CSS keyframes only. Lane A means no JS tweening runtime — these all
         compile to plain CSS animations. */
      keyframes: {
        float: {
          '0%,100%': { transform: 'translateY(0) scale(1)' },
          '50%': { transform: 'translateY(-24px) scale(1.06)' },
        },
        drift: {
          '0%,100%': { transform: 'translate(0,0)' },
          '33%': { transform: 'translate(40px,-30px)' },
          '66%': { transform: 'translate(-30px,25px)' },
        },
        marquee: { from: { transform: 'translateX(0)' }, to: { transform: 'translateX(-50%)' } },
        shimmer: { '100%': { transform: 'translateX(100%)' } },
        popIn: {
          from: { opacity: 0, transform: 'scale(.94) translateY(12px)' },
          to: { opacity: 1, transform: 'none' },
        },
        fadeIn: { from: { opacity: 0 }, to: { opacity: 1 } },
        // used by shadcn overlays via tailwindcss-animate
        'accordion-down': { from: { height: '0' }, to: { height: 'var(--radix-accordion-content-height)' } },
        'accordion-up': { from: { height: 'var(--radix-accordion-content-height)' }, to: { height: '0' } },
      },
      animation: {
        float: 'float 14s ease-in-out infinite',
        drift: 'drift 22s ease-in-out infinite',
        marquee: 'marquee 38s linear infinite',
        shimmer: 'shimmer 1.8s infinite',
        popIn: 'popIn .35s cubic-bezier(.2,.9,.3,1.2) both',
        fadeIn: 'fadeIn .3s ease both',
        'accordion-down': 'accordion-down .2s ease-out',
        'accordion-up': 'accordion-up .2s ease-out',
      },

      backdropBlur: { xs: '2px' },
    },
  },
  plugins: [require('tailwindcss-animate')],
}
