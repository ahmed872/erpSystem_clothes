import type { Config } from 'tailwindcss';

/**
 * Shared with @retail/ui-kit (content globs include the package source, not
 * a build output) so utility classes used inside shared components are
 * generated here too — the POS app is the only consumer of ui-kit right
 * now, so this is the one Tailwind build in the repo. ERP web will get an
 * identical config when it is built.
 */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}', '../../packages/ui-kit/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Cairo', 'Tajawal', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
      },
      colors: {
        brand: {
          50: '#eef6ff',
          100: '#d9eaff',
          200: '#bcdaff',
          300: '#8ec2ff',
          400: '#59a2ff',
          500: '#3380f6',
          600: '#175ce0',
          700: '#134fb3',
          800: '#153f8c',
          900: '#173768',
        },
        neutral: {
          50: '#f7f7f8',
          100: '#eeeef0',
          200: '#dcdde1',
          300: '#c2c4cb',
          400: '#9a9da7',
          500: '#75778a',
          600: '#5b5f6b',
          700: '#454852',
          800: '#2e3038',
          900: '#14151a',
        },
        success: {
          50: '#e7f7ef',
          600: '#0f8a4b',
          700: '#067647',
          800: '#065f3a',
        },
        warning: {
          50: '#fff4e5',
          600: '#d1650a',
          700: '#b54708',
          800: '#8f3906',
        },
        danger: {
          50: '#fef3f2',
          200: '#fecdca',
          300: '#fda29b',
          400: '#f97066',
          600: '#d92d20',
          700: '#b42318',
          800: '#912018',
        },
      },
      borderRadius: {
        xl: '14px',
        '2xl': '20px',
      },
    },
  },
  plugins: [],
} satisfies Config;
