(function () {
  var query = new URLSearchParams(window.location.search || "");
  var creatorConfiguredStatsUrl = query.get("statsUrl") || "";
  var creatorConfiguredStatsToken = query.get("statsToken") || "";

  var iconLight = new URL("./assets/openclaw-icon-light.svg", window.location.href).toString();
  var iconDark = new URL("./assets/openclaw-icon-dark.svg", window.location.href).toString();

  function normalizeConfig(raw) {
    var cfg = raw || {};
    return {
      statsUrl: String(cfg.statsUrl || "").trim(),
      statsToken: String(cfg.statsToken || "").trim(),
      instanceName: String(cfg.instanceName || "").trim(),
    };
  }

  async function loadBoardConfig(t) {
    var boardConfig = await t.get("board", "shared", "openclawStatsConfig");
    var normalized = normalizeConfig(boardConfig);
    if (!normalized.statsUrl && creatorConfiguredStatsUrl) {
      normalized.statsUrl = creatorConfiguredStatsUrl;
    }
    if (!normalized.statsToken && creatorConfiguredStatsToken) {
      normalized.statsToken = creatorConfiguredStatsToken;
    }
    return normalized;
  }

  window.TrelloPowerUp.initialize({
    "show-settings": function (t) {
      return t.popup({
        title: "OpenClaw Stats Settings",
        url: "./settings.html?v=20260418b",
        height: 520,
      });
    },
    "board-buttons": function (t) {
      return [
        {
          icon: {
            dark: iconLight,
            light: iconDark,
          },
          text: "OpenClaw Stats",
          condition: "edit",
          callback: async function (ctx) {
            var config = await loadBoardConfig(ctx);
            return ctx.modal({
              title: "OpenClaw Trello Session Stats",
              url: ctx.signUrl("./modal.html", {
                statsUrl: config.statsUrl,
                statsToken: config.statsToken,
                instanceName: config.instanceName,
              }),
              accentColor: "#0E7490",
              fullscreen: false,
              height: 560,
            });
          },
        },
      ];
    },
  });
})();
