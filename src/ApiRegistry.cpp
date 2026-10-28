#include "deadlock/ApiRegistry.h"

#include "llvm/Support/JSON.h"
#include "llvm/Support/MemoryBuffer.h"

namespace deadlock {

ApiRegistry::ApiRegistry() {
    const ApiSpec defaults[] = {
        {"mutex_lock", "lock_acquire", 0, -1, -1},
        {"mutex_unlock", "lock_release", 0, -1, -1},
        {"spin_lock", "lock_acquire", 0, -1, -1},
        {"spin_unlock", "lock_release", 0, -1, -1},
        {"spin_lock_irq", "lock_acquire_irq", 0, -1, -1},
        {"spin_unlock_irq", "lock_release_irq", 0, -1, -1},
        // Linux spinlock headers commonly expand public macros to these
        // implementation entry points. The AST visitor prefers the public
        // macro token and recovers return-flags assignments when available.
        {"raw_spin_lock", "lock_acquire", 0, -1, -1},
        {"raw_spin_unlock", "lock_release", 0, -1, -1},
        {"_raw_spin_lock", "lock_acquire", 0, -1, -1},
        {"_raw_spin_unlock", "lock_release", 0, -1, -1},
        {"__raw_spin_lock", "lock_acquire", 0, -1, -1},
        {"__raw_spin_unlock", "lock_release", 0, -1, -1},
        {"raw_spin_lock_irq", "lock_acquire_irq", 0, -1, -1},
        {"raw_spin_unlock_irq", "lock_release_irq", 0, -1, -1},
        {"_raw_spin_lock_irq", "lock_acquire_irq", 0, -1, -1},
        {"_raw_spin_unlock_irq", "lock_release_irq", 0, -1, -1},
        {"__raw_spin_lock_irq", "lock_acquire_irq", 0, -1, -1},
        {"__raw_spin_unlock_irq", "lock_release_irq", 0, -1, -1},
        {"spin_lock_irqsave", "lock_acquire_irqsave", 0, 1, -1},
        {"spin_unlock_irqrestore", "lock_release_irqrestore", 0, 1, -1},
        {"spin_lock_irqsave_nested", "lock_acquire_irqsave", 0, 1, -1},
        {"raw_spin_lock_irqsave", "lock_acquire_irqsave", 0, 1, -1},
        {"raw_spin_unlock_irqrestore", "lock_release_irqrestore", 0, 1, -1},
        {"raw_spin_lock_irqsave_nested", "lock_acquire_irqsave", 0, 1, -1},
        {"_raw_spin_lock_irqsave", "lock_acquire_irqsave", 0, 1, -1},
        {"_raw_spin_unlock_irqrestore", "lock_release_irqrestore", 0, 1, -1},
        {"__raw_spin_lock_irqsave", "lock_acquire_irqsave", 0, 1, -1},
        {"__raw_spin_unlock_irqrestore", "lock_release_irqrestore", 0, 1, -1},
        {"local_irq_save", "irq_save", -1, 0, -1},
        {"local_irq_restore", "irq_restore", -1, 0, -1},
        {"local_irq_disable", "irq_disable", -1, -1, -1},
        {"local_irq_enable", "irq_enable", -1, -1, -1},
        {"request_irq", "interrupt_register", -1, -1, 1},
        {"free_irq", "interrupt_unregister", -1, -1, -1},
    };
    for (const auto &spec : defaults)
        entries_.emplace(spec.name, spec);
}

bool ApiRegistry::loadFile(const std::string &path, std::string &error) {
    auto buffer = llvm::MemoryBuffer::getFile(path);
    if (!buffer) {
        error = "cannot read API config '" + path + "': " + buffer.getError().message();
        return false;
    }
    auto parsed = llvm::json::parse((*buffer)->getBuffer());
    if (!parsed) {
        error = "invalid API config JSON: " + llvm::toString(parsed.takeError());
        return false;
    }
    auto *root = parsed->getAsObject();
    if (!root) {
        error = "API config root must be a JSON object";
        return false;
    }
    auto *apis = root->getArray("apis");
    if (!apis) {
        error = "API config must contain an 'apis' array";
        return false;
    }

    auto updated = entries_;
    for (const auto &entry : *apis) {
        auto *object = entry.getAsObject();
        if (!object) {
            error = "each API config entry must be an object";
            return false;
        }
        auto name = object->getString("name");
        auto kind = object->getString("kind");
        if (!name || !kind || name->empty() || kind->empty()) {
            error = "each API config entry needs non-empty 'name' and 'kind' strings";
            return false;
        }
        int lockArgument = -1;
        if (auto argument = object->getInteger("lock_argument")) {
            if (*argument < 0 || *argument > 1024) {
                error = "lock_argument must be between 0 and 1024";
                return false;
            }
            lockArgument = static_cast<int>(*argument);
        }
        int stateArgument = -1;
        if (auto argument = object->getInteger("state_argument")) {
            if (*argument < 0 || *argument > 1024) {
                error = "state_argument must be between 0 and 1024";
                return false;
            }
            stateArgument = static_cast<int>(*argument);
        }
        int handlerArgument = -1;
        if (auto argument = object->getInteger("handler_argument")) {
            if (*argument < 0 || *argument > 1024) {
                error = "handler_argument must be between 0 and 1024";
                return false;
            }
            handlerArgument = static_cast<int>(*argument);
        }
        const std::string apiName = name->str();
        const std::string apiKind = kind->str();
        updated[apiName] = ApiSpec{apiName, apiKind, lockArgument,
                                   stateArgument, handlerArgument};
    }
    entries_ = std::move(updated);
    return true;
}

std::optional<ApiSpec> ApiRegistry::find(const std::string &name) const {
    auto found = entries_.find(name);
    if (found == entries_.end())
        return std::nullopt;
    return found->second;
}

} // namespace deadlock
