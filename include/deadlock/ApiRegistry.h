#pragma once

#include <optional>
#include <string>
#include <unordered_map>

namespace deadlock {

struct ApiSpec {
    std::string name;
    std::string kind;
    int lockArgument = -1;
};

class ApiRegistry {
public:
    ApiRegistry();
    bool loadFile(const std::string &path, std::string &error);
    std::optional<ApiSpec> find(const std::string &name) const;
    const std::unordered_map<std::string, ApiSpec> &entries() const { return entries_; }

private:
    std::unordered_map<std::string, ApiSpec> entries_;
};

} // namespace deadlock
