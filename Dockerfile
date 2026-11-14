# Marswalk on Hugging Face Spaces (or any Docker host). Serves the app on port 7860.
FROM python:3.13-slim
RUN useradd -m -u 1000 user
WORKDIR /home/user/app
COPY --chown=user requirements-deploy.txt .
RUN pip install --no-cache-dir -r requirements-deploy.txt
COPY --chown=user . .
USER user
# No Postgres online: this address refuses at once, so the app serves the saved pass files and fetches fresh ones from JPL Horizons.
ENV DATABASE_URL=postgresql://offline@127.0.0.1:1/none \
    PYTHONUNBUFFERED=1
EXPOSE 7860
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "7860", "--proxy-headers", "--forwarded-allow-ips", "*"]
