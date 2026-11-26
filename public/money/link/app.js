(function () {
  const params = new URLSearchParams(window.location.search);
  const src = params.get("src") || "direct";
  const vid = params.get("vid") || "profile";
  const featuredOffer = params.get("offer") || "";

  function appendUtm(rawUrl, offerId) {
    try {
      const parsed = new URL(rawUrl);
      parsed.searchParams.set("utm_source", src);
      parsed.searchParams.set("utm_medium", "short_video");
      parsed.searchParams.set("utm_campaign", vid);
      parsed.searchParams.set("utm_content", offerId);
      return parsed.toString();
    } catch (_err) {
      return rawUrl;
    }
  }

  function recordClick(offerId) {
    try {
      const key = "bio_click_log_v1";
      const log = JSON.parse(localStorage.getItem(key) || "[]");
      log.push({ ts: new Date().toISOString(), src, vid, offerId });
      localStorage.setItem(key, JSON.stringify(log.slice(-200)));
    } catch (_err) {
      // Ignore storage failures in restricted contexts
    }
  }

  function render(data) {
    document.getElementById("brand-name").textContent = data.brand_name;
    document.getElementById("brand-tagline").textContent = data.tagline;

    const emailLink = document.getElementById("sponsor-email-link");
    emailLink.href = "mailto:" + data.contact_email + "?subject=Sponsorship%20Inquiry";

    const kitLink = document.getElementById("media-kit-link");
    if (data.media_kit_url) {
      kitLink.href = data.media_kit_url;
    }

    if (src !== "direct") {
      const pill = document.getElementById("attribution-pill");
      pill.textContent = "Arrived from " + src.toUpperCase() + (vid !== "profile" ? " / " + vid : "");
      pill.classList.remove("hidden");
    }

    const container = document.getElementById("offers-list");
    container.innerHTML = "";

    const ordered = [...(data.offers || [])].sort((a, b) => {
      if (featuredOffer && a.id === featuredOffer) return -1;
      if (featuredOffer && b.id === featuredOffer) return 1;
      return Number(Boolean(b.highlight)) - Number(Boolean(a.highlight));
    });

    for (const offer of ordered) {
      const card = document.createElement("a");
      card.className = "offer-card" + (offer.highlight || offer.id === featuredOffer ? " highlight" : "");
      card.href = appendUtm(offer.url, offer.id);
      card.target = "_blank";
      card.rel = "noopener noreferrer";
      card.addEventListener("click", () => recordClick(offer.id));

      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = offer.badge;

      const title = document.createElement("div");
      title.className = "offer-title";
      title.textContent = offer.title;

      const sub = document.createElement("div");
      sub.className = "offer-sub";
      sub.textContent = offer.subtitle;

      card.append(badge, title, sub);
      container.appendChild(card);
    }
  }

  fetch("links.json")
    .then((res) => res.json())
    .then(render)
    .catch(() => {
      document.getElementById("brand-name").textContent = "Links Ready";
      document.getElementById("brand-tagline").textContent =
        "Serve this folder via HTTP (python3 -m http.server) or deploy to Cloudflare Pages / GitHub Pages.";
    });
})();
