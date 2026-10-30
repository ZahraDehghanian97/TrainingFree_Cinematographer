# Shared-scene camera experiments

All experiments reuse **stadium** or **factory**. No environment is cloned.

Stadium: `دوندهٔ برنده را دنبال کن.` / `زمین‌خوردن دوندهٔ سوم را نشان بده.` / `پرش برنده و گل‌افشانی را از نمای نزدیک بگیر.`

Factory: `قطعات روی ریل را دنبال کن.` / `دو کارگر را در قاب نگه دار.` / `برخورد و ریزش وسایل را نشان بده.`

Leave camera distances, lens and angles omitted unless the prompt explicitly requests them. Scene-event times are supplied to the director.

```
npm run generate:dont-care -- --example stadium --iterations 100
npm run generate:trajectories -- --example factory --iterations 100
```

These commands optimize paths in the existing worlds; they do not create new worlds. The browser's Custom prompt tab runs the live director pipeline and requires API credentials.
