UUID := sleep-inhibitors@local
INSTALL_DIR := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
FILES := metadata.json extension.js inhibitors.js inhibitorLogic.js stylesheet.css LICENSE

.PHONY: install uninstall pack test check

install:
	mkdir -p "$(INSTALL_DIR)"
	cp $(FILES) "$(INSTALL_DIR)/"
	@echo "Installed to $(INSTALL_DIR)"
	@echo "Enable with: gnome-extensions enable $(UUID)"

uninstall:
	rm -rf "$(INSTALL_DIR)"
	@echo "Removed $(INSTALL_DIR)"

pack:
	rm -f $(UUID).shell-extension.zip
	zip -j $(UUID).shell-extension.zip $(FILES)
	@echo "Created $(UUID).shell-extension.zip"

test:
	node --test tests/inhibitorLogic.test.js

check:
	node --check extension.js
	node --check inhibitors.js
	node --check inhibitorLogic.js
	node --check tests/inhibitorLogic.test.js
