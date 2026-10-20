# habit-tracker

Small mobile app for tracking daily habits (Expo + React Native + TypeScript).

```
npm install
npm start          # Expo dev server; press i / a for a simulator
npm test           # store unit tests
npm run typecheck
```

Screens: `HabitsScreen` (add habits, tap to mark today done, see streaks).
Habits live in memory (`src/store/habits.ts`) for now, so they reset when the app restarts.
