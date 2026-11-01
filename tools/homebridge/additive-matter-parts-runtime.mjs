// Installed beside Homebridge's matter/server.js by patch-additive-matter-parts.mjs.
export function updateWithAdditiveParts(accessories) {
  const node = this.serverNode;
  const targets = accessories.map((accessory) => ({ accessory, owner: this.accessories.get(accessory.UUID) }));
  const work = (this.hejhomePartsQueue ?? Promise.resolve()).catch(() => undefined).then(async () => {
    if (!this.accessoryCache) {
      throw new Error('Matter accessory cache is not initialized');
    }
    targetsLoop: for (const { accessory, owner: existing } of targets) {
      if (!existing?.endpoint) {
        throw new Error(`Matter accessory ${accessory.UUID} is not registered`);
      }
      const isCurrent = () => this.serverNode === node && node?.lifecycle.isReady
        && this.accessories.get(accessory.UUID) === existing && existing.endpoint.lifecycle.isReady;
      if (!isCurrent()) {
        continue;
      }
      const cached = this.accessoryCache.getCached(accessory.UUID);
      // Pre-online native restoration does not copy these ownership markers.
      existing._associatedPlugin ||= cached?.plugin;
      existing._associatedPlatform ||= cached?.platform;
      if (existing.deviceType.name !== accessory.deviceType.name) {
        throw new Error('An additive update cannot change the parent device type');
      }
      const wanted = new Map();
      for (const part of accessory.parts ?? []) {
        if (!part.id || wanted.has(part.id)) {
          throw new Error('Matter part IDs must be nonempty and unique');
        }
        wanted.set(part.id, part);
      }
      const current = existing._parts ?? [];
      for (const part of current) {
        const next = wanted.get(part.id);
        if (next && next.deviceType.name !== part.deviceType.name) {
          throw new Error(`An additive update cannot change part ${part.id}'s device type`);
        }
      }
      const additions = [...wanted.values()].filter((part) => !current.some((old) => old.id === part.id));
      if (additions.length && !current.length) {
        throw new Error('Additive parts require an already composed Matter accessory');
      }
      const deps = this.getAccessoryManagerDeps();
      // Keep existing commands usable even if creating a later new part fails.
      this.accessoryManager.registerAccessoryHandlers(accessory, deps);
      for (const part of current) {
        const next = wanted.get(part.id);
        if (!next?.handlers) {
          continue;
        }
        const endpointId = `${accessory.UUID}-part-${part.id}`;
        for (const [cluster, handlers] of Object.entries(next.handlers)) {
          for (const [command, handler] of Object.entries(handlers)) {
            deps.behaviorRegistry.registerHandler(endpointId, cluster, command, handler);
          }
        }
      }
      for (const part of additions) {
        const endpointId = `${accessory.UUID}-part-${part.id}`;
        let created;
        try {
          created = await this.accessoryManager.createAccessoryParts(
            { ...accessory, parts: [part] }, existing.endpoint, deps, current.length, isCurrent,
          );
        } catch (error) {
          if (!isCurrent()) {
            continue targetsLoop;
          }
          const partial = [...existing.endpoint.parts].find((child) => child.id === endpointId);
          if (partial && !current.some((old) => old.endpoint === partial)) {
            await partial.close();
          }
          if (!isCurrent()) {
            continue targetsLoop;
          }
          deps.behaviorRegistry.removeEndpoint(endpointId);
          deps.registryManager.unregisterEndpoint(endpointId);
          throw error;
        }
        if (!isCurrent()) {
          continue targetsLoop;
        }
        current.push(...created);
        existing._parts = current;
        existing.parts = current.map(({ id, displayName, deviceType, clusters, handlers }) => ({ id, displayName, deviceType, clusters, handlers }));
        // Commit each addition: a subsequent failure must not orphan a live part.
        this.accessoryCache.requestSave(this.accessories);
        await this.accessoryManager.notifyPartsListChanged(deps);
        if (!isCurrent()) {
          continue targetsLoop;
        }
      }
      // Retain omitted parts and their order so cache restore keeps semantic tags.
      const metadata = current.map((part) => {
        const next = wanted.get(part.id) ?? existing.parts?.find((old) => old.id === part.id) ?? part;
        return { ...next, clusters: part.clusters };
      });
      // Preserve the container as well as its clusters: an in-flight state report
      // can hold this reference while awaiting its endpoint transaction.
      const clusters = existing.clusters ?? {};
      for (const [name, attributes] of Object.entries(accessory.clusters ?? {})) {
        if (!Object.hasOwn(clusters, name)) {
          clusters[name] = attributes;
        }
      }
      // In-place metadata updates keep queued owner checks valid. Unregister or
      // a new registration replaces/removes the object and invalidates old work.
      Object.assign(existing, {
        ...accessory, clusters, parts: metadata.length ? metadata : accessory.parts,
        endpoint: existing.endpoint, _parts: current.length ? current : existing._parts,
        _eventEmitter: existing._eventEmitter, registered: existing.registered,
        _restoredFromCache: accessory.handlers ? false : existing._restoredFromCache,
      });
      this.accessoryCache.requestSave(this.accessories);
    }
  });
  this.hejhomePartsQueue = work.catch(() => undefined);
  return work;
}
