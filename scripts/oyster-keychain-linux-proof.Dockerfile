FROM node:24-bookworm
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends dbus dbus-user-session gnome-keyring > /dev/null && rm -rf /var/lib/apt/lists/*
