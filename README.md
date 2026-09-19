# BrownStore

Showcase catalog for BrownStore. Products are stored in MongoDB and shown with a modern brown/tan theme. There is no cart and no customer login. Admins can override SKU, price, and stock.

## Stack

- Client: React, Vite, Tailwind CSS
- Server: Node.js, Express
- Database: MongoDB

## Setup

1. Install [MongoDB](https://www.mongodb.com/docs/manual/installation/) and start it locally (or set `MONGO_URL` to Atlas).
2. Copy env file:

```bash
copy server\.env.example server\.env
```

3. Install and run:

```bash
npm install
npm run dev --prefix server
npm run dev --prefix client
```

- Storefront: http://localhost:5173
- API: http://localhost:5000/api/health
- Admin: http://localhost:5173/admin/login

Default admin (change in `server/.env`):

- Email: `admin@brownstore.com`
- Password: `BrownStore!2026`

On first boot the server pulls products if the database is empty. You can also press **Refresh Products** in the admin panel. If local MongoDB is not running, the API starts an in-memory MongoDB for that session.

Admin edits stay in BrownStore and they survive later syncs.

## Logo

`client/public/logo-4k.png` is a 4096×4096 transparent PNG. `logo.png` is used in the header.
