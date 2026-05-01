import { TrelloClient } from "./client";
import { TrelloListsConfig } from "./types";

export interface BoardIds {
  backlogListId: string;
  inProgressListId: string;
  doneListId: string;
  labelColorToId: Record<string, string>;
}

export class TrelloBoardSetup {
  constructor(
    private readonly client: TrelloClient,
    private readonly boardId: string,
    private readonly listsConfig: TrelloListsConfig,
    private readonly agentLabels: Record<string, string>,
  ) {}

  async ensureListsAndLabels(): Promise<BoardIds> {
    const [existingLists, existingLabels] = await Promise.all([
      this.client.getLists(this.boardId),
      this.client.getLabels(this.boardId),
    ]);

    const listMap: Record<string, string> = {};
    const normalize = (value: string): string => String(value || "").trim().toLowerCase();

    const resolveListId = (value: string): string => {
      if (!value) return "";
      const byId = existingLists.find(l => l.id === value);
      if (byId) return byId.id;
      const want = normalize(value);
      const byName = existingLists.find(l => normalize(l.name) === want && !l.closed);
      if (byName) return byName.id;
      return "";
    };

    listMap["backlog"] = resolveListId(this.listsConfig.backlog);
    listMap["inProgress"] = resolveListId(this.listsConfig.inProgress);
    listMap["done"] = resolveListId(this.listsConfig.done);

    if (!listMap["backlog"]) {
      console.warn(`[TrelloChannel] Missing configured list "${this.listsConfig.backlog}" for backlog; using existing board lists only.`);
      listMap["backlog"] = existingLists.find(l => !l.closed)?.id || "";
    }
    if (!listMap["inProgress"]) {
      console.warn(`[TrelloChannel] Missing configured list "${this.listsConfig.inProgress}" for inProgress; cards will stay in their current list unless explicitly moved.`);
      listMap["inProgress"] = listMap["backlog"];
    }
    if (!listMap["done"]) {
      console.warn(`[TrelloChannel] Missing configured list "${this.listsConfig.done}" for done; completion move will fall back to current list.`);
      listMap["done"] = listMap["inProgress"] || listMap["backlog"];
    }

    const labelColorToId: Record<string, string> = {};
    for (const [color, agentName] of Object.entries(this.agentLabels)) {
      const existing = existingLabels.find(l => l.color === color);
      if (existing) {
        labelColorToId[color] = existing.id;
      } else {
        const created = await this.client.createLabel(this.boardId, agentName, color);
        labelColorToId[color] = created.id;
        console.log(`[TrelloChannel] Created label: "${agentName}" (${color})`);
      }
    }

    return {
      backlogListId: listMap["backlog"],
      inProgressListId: listMap["inProgress"],
      doneListId: listMap["done"],
      labelColorToId,
    };
  }
}
