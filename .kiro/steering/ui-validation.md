# UI Change Validation

After every frontend or user-interface change in this workspace:

1. Run `npm run build` in `frontend`.
2. Run `npm run lint` in `frontend`.
3. Start or reuse the complete local application through `./run.sh` so the production React build is served by FastAPI at `http://localhost:8000`.
4. Smoke-test the served HTML, built assets, and `/api/health` endpoint.
5. Keep the server running for user inspection when practical.
6. Report the exact preview URL, checks performed, and any behavior that could not be visually verified. Never claim visual browser verification when only HTTP/build checks were available.

Use the dashboard screenshots supplied in chat as the visual target: dark navy command-center styling, cyan outlines, compact status telemetry, dense card layouts, bottom tile navigation where appropriate, and a day/night world-time map.
