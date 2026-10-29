#!/bin/sh
# Replaces the postgis image init script so it does not pre-install PostGIS,
# topology and tiger geocoder. The Prisma migrations create the extensions the
# app needs (postgis, btree_gist), as they would on Azure.
