# rokgol.github.io

Personal site of Yotam Ravid. Static, front end only, no build step.

- `index.html`: content
- `style.css`: layout for phone and desktop
- `field.js`: live 2D wave-equation background. Ripples come from the last 24 h of earthquakes ([USGS feed](https://earthquake.usgs.gov/earthquakes/feed/v1.0/geojson.php)), clicks and taps, and phone tilt (asks permission first).
- `assets/photo.jpg`: profile picture (initials show until it exists)
- `assets/cv.pdf`: CV

Run locally: `python -m http.server`, then open http://localhost:8000.
