# rokgol.github.io

Personal site of Yotam Ravid. Static, front end only, no build step.

- `index.html`: content
- `style.css`: layout for phone and desktop
- `field.js`: live wave tank, the 2D scalar wave equation with absorbing edges. Drag to disturb it, swipe or scroll to send a wave across, hover a box to send one up from below, tilt a phone to roll a ball (asks permission first). "Add an optical fiber" adds a bent fiber (core n = 1.5, cladding n = 1.499, in air) with a phase-matched laser at its input, so you can watch total internal reflection guide the light.
- `assets/photo.jpg`: profile picture (initials show until it exists)
- `assets/cv.pdf`: CV

Run locally: `python -m http.server`, then open http://localhost:8000.
