# Aurora Transcribe

Aurora Transcribe is a polished voice transcription studio that runs entirely in your browser. Bring your own OpenAI API key and switch between GPT-4o mini transcribe for speed or GPT-4o transcribe for premium accuracy. Record live audio, upload existing files, and keep beautifully formatted transcripts in one place.

## Highlights

- **Live capture** with an animated waveform, recording timer, and one-click copy or download of transcripts.
- **Model switcher** between GPT-4o mini transcribe (fast) and GPT-4o transcribe (highest fidelity).
- **Upload support** for existing audio or video files—no extra backend required.
- **Productivity boosts** including auto-copy, local history storage, custom prompt, language hints, translation toggle, and adjustable temperature.
- **Personalized look** with ambient glows, dark glassmorphism cards, and persistent preferences stored locally.

## Getting started

1. Install dependencies:
   ```bash
   npm install
   ```
2. Run the development server:
   ```bash
   npm run dev
   ```
3. Open the printed local URL in your browser and add your OpenAI API key to start transcribing.

## Deploying to Vercel

1. Connect this repository to Vercel and select the **Vite** preset.
2. Set the build command to `npm run build` and the output directory to `dist` (defaults for Vite).
3. Deploy. Every push to `main` will trigger a production build; branches receive preview deployments automatically.

To create a production build, run `npm run build`. The output lives in `dist/`.

## Using Aurora Transcribe

1. Paste your OpenAI API key into the **Bring your API key** field. Toggle **Remember** to store it locally (never sent anywhere else).
2. Choose between *GPT-4o mini transcribe* or *GPT-4o transcribe* under **Choose a model**.
3. Hit **Start recording** for live capture or **Upload audio** to send an existing file.
4. Optional enhancements:
   - Provide a language hint or custom prompt.
   - Enable translation to English, auto-copy, history retention, or the waveform visualiser.
   - Adjust temperature to balance creativity and accuracy.
5. Grab your polished transcript using the copy or download buttons. Previous sessions stay in **Session history** stored locally in your browser.

## Notes on privacy

- All API calls go straight from your browser to OpenAI using the key you provide.
- Keys and transcripts are stored locally in your browser's storage and never leave your device.
- Clearing **Remember** immediately deletes the stored key from local storage.
- No backend servers, databases, or user accounts required.

Enjoy crafting effortless, aesthetically pleasing transcripts!
