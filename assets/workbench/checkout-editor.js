function scmToolkitAllowCheckoutEditor(service, commandService, input) {
    if (service.configurationService.getValue('sweetiebot.singleRepositoryPerWindow') === false) return true;
    const resources = service.extractEditorResources([input]).resources.filter(uri =>
        uri.scheme === 'git' || (uri.scheme === 'file' && service.contextService.getWorkspaceFolder(uri)?.index !== 0));
    if (!resources.length || !service.contextService.getWorkspace().folders.length) return true;
    return service.instantiationService.invokeFunction(accessor =>
        accessor.get(commandService).executeCommand('sweetiebot.allowCheckoutEditor', resources)
    ).then(allowed => allowed !== false, () => true);
}
