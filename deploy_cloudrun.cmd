@echo off
rem Deploy Marswalk to Google Cloud Run. Run once after: gcloud auth login, and gcloud config set project YOUR_PROJECT_ID
cd /d "%~dp0"
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com
gcloud run deploy marswalk --source . --region europe-west1 --allow-unauthenticated --port 7860 --memory 2Gi --cpu 2 --cpu-boost --min-instances 0 --max-instances 2 --timeout 300 --set-env-vars DATABASE_URL=postgresql://offline@127.0.0.1:1/none
