# MinibusGo admin panel

Served by the same Express server. Open: http://localhost:4000/admin

## Set up (existing database, keeps your data)
    cd backend
    npm run db:migrate
    npm run admin:create -- admin YourStrongPassword "Your Name"
    npm run dev
Fresh install: `npm run db:init` already includes the admin tables (this wipes data), then `db:seed`, then `admin:create`.

## Roles
- admin    : everything (operators, routes, staff accounts, all trips and bookings)
- operator : manages trips + sees bookings/stats for their own company only
- scanner  : station staff. Sees trips + passenger lists + scans tickets, own company only

## First steps in the panel
1. Operators: add each company.   2. Routes: add routes (tick "return route").
3. Staff accounts: create an operator login per company and scanner logins for stations.
4. Trips -> "+ Add trips": pick route, dates, times (07:00, 15:00), price.
The seed trips are only demo data. Remove them later by cancelling, or reset with db:init.
