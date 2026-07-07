const main = async (): Promise<void> => {
  const [msisdn] = process.argv.slice(2);
  if (!msisdn) {
    console.error('Usage: verify-mts-sync-one.ts <msisdn>');
    process.exit(1);
  }

  const { mtsBusinessMappingService } = await import('../src/services/mts-business-mapping.service.js');
  const { syncSubscriberFull } = await import('../src/services/mts-business-subscriber-sync.service.js');

  const ctx = await mtsBusinessMappingService.getSubscriberContext(msisdn);
  if (!ctx) {
    console.error('Номер не найден');
    process.exit(1);
  }
  const r = await syncSubscriberFull(ctx.accountId, msisdn);
  console.log(JSON.stringify(r, null, 2));
};

main().catch(e => {
  console.error(e);
  process.exit(1);
});
