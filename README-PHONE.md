# Grok Connector — Phone Deployment

This version is prepared for a phone-first deployment.

## Recommended path: Render + GitHub

1. Create a GitHub repository named `grok-connector`.
2. Upload all files in this folder to the repository.
3. Open Render and choose **New → Web Service**.
4. Connect the GitHub repository.
5. Render can use the included `render.yaml`.
6. In Render → Environment Variables, add:
   `XAI_API_KEY` = your NEW xAI key.
7. Deploy.
8. Open the generated `onrender.com` URL and confirm the status says online.
9. Test `YOUR_URL/health`.
10. The API endpoint is `POST YOUR_URL/api/grok`.

The key is never placed in the browser code.

## Test request body

{"input":"Grok, are you there? Reply briefly."}

## Important

Do not upload a real `.env` file or put the API key into GitHub.
