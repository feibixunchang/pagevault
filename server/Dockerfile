# PageVault sync server — self-hostable image (the "Docker" end of the 6-end plan)
FROM node:20-alpine

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev || true
COPY server.js ./
COPY public ./public

# Persist captured pages outside the container
VOLUME ["/app/data"]
ENV PORT=8731
EXPOSE 8731

CMD ["node", "server.js"]
