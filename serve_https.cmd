@echo off
rem Marswalk over https so a phone can use the microphone. Accept the certificate warning once per device.
cd /d "%~dp0"
.venv\Scripts\python -m uvicorn app.main:app --host 0.0.0.0 --port 8443 --ssl-keyfile certs\key.pem --ssl-certfile certs\cert.pem --reload
