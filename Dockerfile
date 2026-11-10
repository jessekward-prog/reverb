FROM node:20
# Every "today" and weekday in this app is Melbourne's. Without this the
# container is UTC, and before 11am AEDT "today" is yesterday.
ENV TZ=Australia/Melbourne
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build
EXPOSE 3000
CMD ["node", "server.js"]
