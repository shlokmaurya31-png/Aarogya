# Aarogya AI

India's unified health intelligence platform: one permanent health record for every patient, read by AI, verified by labs, and understood by every doctor they'll ever meet.

Aarogya AI is a prototype health-record and clinical-workflow platform connecting **patients**, **doctors**, **hospitals**, **labs**, and **insurers** around a single longitudinal record. It ships as a cinematic marketing site plus a fully interactive command-center dashboard with separate patient and doctor experiences.

## Features

- **Dual-mode dashboard**: switch between a Patient view (health score, medicines, appointments, AI assistant) and a Doctor view (clinical summary, SOAP briefs, lab results, prescriptions) from one toggle.
- **AI health assistant**: a chat-style panel where patients can ask questions, get voice input (Web Speech API), and upload a health record for the AI to "analyze"; the resulting summary is added to the patient's Reports and surfaces on the doctor's side too.
- **Doctor-authored prescriptions**: a form doctors fill with their name/registration/facility once and reuse, issuing new prescriptions that show up live in the patient's Medicines view.
- **Emergency SOS, appointment booking, refill requests, report downloads, and directions/video-call actions**: all wired to real client-side state and feedback (toasts), not static mockups.
- **Multi-language dashboard**: a language switcher in the top bar translates the UI into English, Hindi, Bengali, Marathi, Telugu, Tamil, Gujarati, Urdu, Kannada, Odia, and Malayalam (with automatic RTL for Urdu).
- **Cinematic landing page**: an animated hero with a scrubbable background video, staggered-word headline, and sections covering the platform's features, AI diagnosis, timeline, pricing, and FAQ.

## Tech stack

- [Next.js 16](https://nextjs.org) (App Router) + React 19 + TypeScript
- [Tailwind CSS 4](https://tailwindcss.com) with a custom design-token system (light theme)
- [Framer Motion](https://www.framer.com/motion/) for animation, [Lenis](https://github.com/darkroomengineering/lenis) for smooth scroll
- [Zustand](https://github.com/pmndrs/zustand) for shared client state (UI mode, records, prescriptions, toasts, language)
- [Recharts](https://recharts.org) for vitals charts, [lucide-react](https://lucide.dev) for icons
- [React Three Fiber](https://docs.pmnd.rs/react-three-fiber) / drei (available for 3D work, not currently on the critical path)

## Getting started

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) for the landing page, or [http://localhost:3000/dashboard](http://localhost:3000/dashboard) to jump straight into the app.

Other scripts:

```bash
npm run build   # production build
npm run start   # serve the production build
npm run lint    # run ESLint
```

## Project structure

```
src/
  app/                # Next.js routes (landing page, /dashboard)
  components/
    ai/                # AI assistant panel
    charts/            # vitals charts
    dashboard/         # health score, systems, notifications, clinical brief
    landing/           # hero, nav, and marketing sections
    navigation/        # top bar, mode toggle, language switcher
    patient/           # patient profile card
    shared/            # loading screen, toasts, language effect
    timeline/          # health event timeline
    ui/                # low-level building blocks (Card, StatusPill, ...)
    views/             # per-tab dashboard screens, doctor + patient
  hooks/               # useTranslation
  lib/                 # mock data, i18n dictionary, risk/plain-language helpers
  store/               # Zustand stores (UI, records, toasts, language)
  types/               # shared TypeScript types
```

## Notes

This is a prototype built on mock data with no backend. All "records," "prescriptions," and "AI analysis" are simulated client-side via shared state, and translations are hand-written rather than sourced from a verified translation service. Both should be reviewed before any real clinical or production use.
