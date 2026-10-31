import catalog from "../../data/public/catalog.json";
import uris from "../../data/letterboxd-uris.json";

// Read by the admin's Letterboxd export, so it uses what the site serves.
export const GET = () => Response.json({ films: catalog, uris });
