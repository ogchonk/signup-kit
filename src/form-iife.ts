import { attachSignupForm, statusFor, submitSignup } from "./form"

/* Built to dist/form.iife.js for sites with no bundler. Exposes window.SignupKit. */
;(globalThis as unknown as { SignupKit: unknown }).SignupKit = { attachSignupForm, statusFor, submitSignup }
